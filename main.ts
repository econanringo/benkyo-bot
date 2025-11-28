import { messagingApi, validateSignature, WebhookEvent } from "npm:@line/bot-sdk";
import "jsr:@std/dotenv/load";

const { MessagingApiClient } = messagingApi;

// 環境変数の取得
const channelAccessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const channelSecret = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";

if (!channelAccessToken || !channelSecret) {
  console.error("エラー: LINE_CHANNEL_ACCESS_TOKEN または LINE_CHANNEL_SECRET が設定されていません。");
}

const client = new MessagingApiClient({
  channelAccessToken: channelAccessToken,
});

const kv = await Deno.openKv();

const broadcastMessage = {
  type: "text",
  text: "1時間が経過しました！定期連絡です。",
} as const;

interface UserData {
  startTime: number;    // 通知を開始した時間
  lastSentTime: number; // 最後にメッセージを送った時間
}

// -----------------------------------------------------------------------------
// 1. Webhookハンドラ
// -----------------------------------------------------------------------------
async function handleEvent(event: WebhookEvent) {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const userId = event.source.userId;
  if (!userId) return;

  const text = event.message.text.trim().toLowerCase();
  const replyToken = event.replyToken;

  let replyText = "";

  if (text === "start") {
    const now = Date.now();
    const userData: UserData = {
      startTime: now,
      lastSentTime: now,
    };
    // ユーザー情報を保存
    await kv.set(["users", userId], userData);
    replyText = "定期通知を開始しました！\nこれから1時間ごとにメッセージを送ります。\n止める場合は 'stop' と送ってください。";
    console.log(`User registered: ${userId} at ${new Date(now).toISOString()}`);

  } else if (text === "stop") {
    await kv.delete(["users", userId]);
    replyText = "定期通知を停止しました。";
    console.log(`User unregistered: ${userId}`);

  } else {
    replyText = "コマンドが認識できません。\n'start' で通知開始\n'stop' で通知停止\nを行います。";
  }

  await client.replyMessage({
    replyToken: replyToken,
    messages: [{ type: "text", text: replyText }],
  });
}

// -----------------------------------------------------------------------------
// 2. サーバー設定
// -----------------------------------------------------------------------------
Deno.serve(async (req) => {
  const pathname = new URL(req.url).pathname;

  if (req.method === "GET") {
    return new Response("LINE Bot is running (Per-user timer mode)");
  }

  if (req.method === "POST" && (pathname === "/webhook" || pathname === "/")) {
    const signature = req.headers.get("x-line-signature");
    const body = await req.text();

    if (!signature || !validateSignature(body, channelSecret, signature)) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const data = JSON.parse(body);
      const events: WebhookEvent[] = data.events;
      await Promise.all(events.map((event) => handleEvent(event)));
      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Webhook Error:", err);
      return new Response("Error", { status: 500 });
    }
  }

  return new Response("Not Found", { status: 404 });
});

// -----------------------------------------------------------------------------
// 3. 定期実行 (Cron) - 1分ごとにチェック
// -----------------------------------------------------------------------------
// 毎分実行して、送信タイミングが来ているユーザーを探す
Deno.cron("Check User Timers", "* * * * *", async () => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000; // 1時間 (ミリ秒)

  const iter = kv.list<UserData>({ prefix: ["users"] });
  
  for await (const entry of iter) {
    const userId = entry.key[1] as string;
    const userData = entry.value;

    // 前回の送信から1時間以上経過しているかチェック
    if (now - userData.lastSentTime >= oneHour) {
      console.log(`Sending message to ${userId} (Last sent: ${new Date(userData.lastSentTime).toISOString()})`);

      try {
        await client.pushMessage({
          to: userId,
          messages: [broadcastMessage],
        });

        // 次回のために lastSentTime を更新
        // ズレを防ぐため、単純に現在時刻にするのではなく「前回の予定時刻 + 1時間」にする手もあるが、
        // Cronの遅延などを考慮してシンプルに「送った時間(now)」で更新する
        const newUserData: UserData = {
          ...userData,
          lastSentTime: now,
        };
        await kv.set(entry.key, newUserData);
        
      } catch (error) {
        console.error(`Failed to send to ${userId}:`, error);
      }
    }
  }
});
