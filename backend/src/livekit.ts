import { AccessToken } from "livekit-server-sdk";
import type { Config } from "./config.js";
import { AGENT_DISPLAY_NAME, AGENT_IDENTITY, type Gender, type Lang, type Tone } from "./types.js";

export interface HumanTokenInput {
  userId: string;
  displayName: string;
  lang: Lang;
  gender: Gender;
  tone: Tone;
  roomName: string;
}

/**
 * identity / name / ttl / attributes are AccessToken CONSTRUCTOR options, never grant fields;
 * putting identity inside addGrant() silently joins with an empty identity.
 * toJwt() is async in server-sdk v2 — a missing await yields the string "[object Promise]".
 */
export async function mintHumanToken(cfg: Config, input: HumanTokenInput): Promise<string> {
  const at = new AccessToken(cfg.livekitApiKey, cfg.livekitApiSecret, {
    identity: input.userId,
    name: input.displayName,
    ttl: cfg.tokenTtlSeconds,
    attributes: {
      uid: input.userId,
      name: input.displayName,
      lang: input.lang,
      gender: input.gender,
      tone: input.tone,
      role: "human",
    },
  });
  // canPublish/canSubscribe are set explicitly: omitting BOTH enables BOTH.
  at.addGrant({
    roomJoin: true,
    room: input.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}

export async function mintAgentToken(cfg: Config, roomName: string): Promise<string> {
  const at = new AccessToken(cfg.livekitApiKey, cfg.livekitApiSecret, {
    identity: AGENT_IDENTITY,
    name: AGENT_DISPLAY_NAME,
    ttl: cfg.tokenTtlSeconds,
    attributes: {
      uid: AGENT_IDENTITY,
      name: AGENT_DISPLAY_NAME,
      lang: "",
      gender: "u",
      tone: "neutral",
      role: "agent",
    },
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    agent: true,
  });
  return at.toJwt();
}
