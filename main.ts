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

// Deno KV のデータベースを開く
const kv = await Deno.openKv();

// 定期送信するメッセージ
const broadcastMessage = {
  type: "text",
  text: "1時間が経過しました！定期連絡です。",
} as const;

// -----------------------------------------------------------------------------
// 1. Webhookハンドラ (LINEからのメッセージ受信)
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
    // KVにユーザーを登録 (Key: ["subscribers", userId], Value: true)
    await kv.set(["subscribers", userId], true);
    replyText = "定期通知を開始しました！\n止める場合は 'stop' と送ってください。";
    console.log(`User registered: ${userId}`);

  } else if (text === "stop") {
    // KVからユーザーを削除
    await kv.delete(["subscribers", userId]);
    replyText = "定期通知を停止しました。\n再開する場合は 'start' と送ってください。";
    console.log(`User unregistered: ${userId}`);

  } else {
    replyText = "コマンドが認識できません。\n'start' で通知開始\n'stop' で通知停止\nを行います。";
  }

  // 応答メッセージを送信
  await client.replyMessage({
    replyToken: replyToken,
    messages: [{ type: "text", text: replyText }],
  });
}

// -----------------------------------------------------------------------------
// 2. サーバー設定 (Webhookのエンドポイント)
// -----------------------------------------------------------------------------
Deno.serve(async (req) => {
  // ヘルスチェック用 (ブラウザでアクセスした時など)
  if (req.method === "GET") {
    return new Response("LINE Bot is running with Deno KV!");
  }

  const pathname = new URL(req.url).pathname;

  // Webhookリクエスト (POST)
  // /webhook でもルート(/)でも受け付けるように変更
  if (req.method === "POST" && (pathname === "/webhook" || pathname === "/")) {
    const signature = req.headers.get("x-line-signature");
    const body = await req.text();

    // 署名検証 (LINEからの正当なリクエストか確認)
    if (!signature || !validateSignature(body, channelSecret, signature)) {
      console.error("署名検証に失敗しました");
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const data = JSON.parse(body);
      const events: WebhookEvent[] = data.events;

      // 各イベントを処理
      await Promise.all(events.map((event) => handleEvent(event)));

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Webhook処理エラー:", err);
      return new Response("Error", { status: 500 });
    }
  }

  return new Response("Not Found", { status: 404 });
});

// -----------------------------------------------------------------------------
// 3. 定期実行 (Cron) - 登録者全員に送信
// -----------------------------------------------------------------------------
Deno.cron("Send Hourly Message", "0 * * * *", async () => {
  console.log("定期送信ジョブを開始します...");
  
  const subscribers = [];
  
  // KVから登録者を全件取得
  const iter = kv.list<boolean>({ prefix: ["subscribers"] });
  for await (const entry of iter) {
    if (entry.value === true) {
      // キーの2番目の要素がuserId
      subscribers.push(entry.key[1] as string);
    }
  }

  if (subscribers.length === 0) {
    console.log("送信対象がいません。");
    return;
  }

  console.log(`送信対象: ${subscribers.length}人`);

  // 一斉送信 (Multicast)
  // LINE Messaging APIのmulticastは一度に最大500人まで送れます
  // 人数が多い場合は分割する必要がありますが、ここでは簡易的にそのまま送ります
  try {
    // 500人ずつに分割して送信する簡単なロジック
    const chunkSize = 500;
    for (let i = 0; i < subscribers.length; i += chunkSize) {
      const chunk = subscribers.slice(i, i + chunkSize);
      await client.multicast({
        to: chunk,
        messages: [broadcastMessage],
      });
    }
    console.log("全員への送信が完了しました！");
  } catch (error) {
    console.error("一斉送信エラー:", error);
  }
});
