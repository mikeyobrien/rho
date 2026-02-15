#!/usr/bin/env tsx

import { Api } from "../extensions/telegram/api.ts";

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatIdRaw = process.env.TELEGRAM_SMOKE_CHAT_ID || "";

  if (!token.trim()) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    process.exit(1);
  }
  if (!chatIdRaw.trim()) {
    console.error("Missing TELEGRAM_SMOKE_CHAT_ID");
    process.exit(1);
  }

  const chatId = Number(chatIdRaw);
  if (!Number.isFinite(chatId)) {
    console.error("TELEGRAM_SMOKE_CHAT_ID must be numeric");
    process.exit(1);
  }

  const client = new Api(token.trim());

  const text = `rho telegram smoke: ${new Date().toISOString()}`;
  const sent = await client.sendMessage(chatId, text);

  console.log(`sent message_id=${sent.message_id} chat_id=${sent.chat.id}`);

  const updates = await client.getUpdates({ timeout: 1, offset: 0, allowed_updates: ["message"] });
  console.log(`fetched updates=${updates.length}`);
}

main().catch((err) => {
  console.error((err as Error)?.message || String(err));
  process.exit(1);
});
