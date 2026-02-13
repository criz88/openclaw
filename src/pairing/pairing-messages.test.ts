import { describe, expect, it } from "vitest";
import { buildPairingReply } from "./pairing-messages.js";

describe("buildPairingReply", () => {
  const cases = [
    {
      channel: "discord",
      idLine: "Your Discord user id: 1",
      code: "ABC123",
    },
    {
      channel: "slack",
      idLine: "Your Slack user id: U1",
      code: "DEF456",
    },
    {
      channel: "signal",
      idLine: "Your Signal number: +15550001111",
      code: "GHI789",
    },
    {
      channel: "imessage",
      idLine: "Your iMessage sender id: +15550002222",
      code: "JKL012",
    },
    {
      channel: "whatsapp",
      idLine: "Your WhatsApp phone number: +15550003333",
      code: "MNO345",
    },
  ] as const;

  for (const testCase of cases) {
    it(`formats pairing reply for ${testCase.channel}`, () => {
      const text = buildPairingReply(testCase);
      expect(text).toContain(testCase.idLine);
      expect(text).toContain(`Pairing code: ${testCase.code}`);
      expect(text).toContain("Ask the bot owner to approve in OpenClaw App:");
      expect(text).toContain("A Pairing Request popup appears automatically on top of any page.");
      expect(text).toContain(
        "If it was ignored: Open OpenClaw Desktop -> Channels -> Pending List -> enter this Pairing code.",
      );
    });
  }
});
