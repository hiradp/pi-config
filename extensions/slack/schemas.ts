import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "@earendil-works/pi-ai";

const Cursor = Type.Optional(
  Type.String({ minLength: 1, maxLength: 2_000, description: "Pagination cursor from Slack." }),
);

export const SlackSearchParams = Type.Object(
  {
    kind: StringEnum(["messages", "channels"] as const, {
      description: "Whether to search messages or channels.",
    }),
    query: Type.String({ minLength: 1, maxLength: 1_000, description: "Slack search query." }),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results for this page." }),
    ),
    cursor: Cursor,
  },
  { additionalProperties: false },
);

export const SlackReadChannelParams = Type.Object(
  {
    channelId: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Z][A-Z0-9]+$",
      description: "Slack channel, private-channel, DM, or MPIM ID.",
    }),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "Maximum messages for this page." }),
    ),
    cursor: Cursor,
  },
  { additionalProperties: false },
);

export const SlackReadThreadParams = Type.Object(
  {
    channelId: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Z][A-Z0-9]+$",
      description: "Slack conversation ID containing the thread.",
    }),
    threadTs: Type.String({
      pattern: "^\\d{1,20}\\.\\d{1,20}$",
      maxLength: 41,
      description: "Timestamp of the thread's parent message.",
    }),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "Maximum replies for this page." }),
    ),
    cursor: Cursor,
  },
  { additionalProperties: false },
);

export const SlackSearchUsersParams = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 320,
      description: "Name, email, or Slack user ID to search for.",
    }),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 20, description: "Maximum users for this page." }),
    ),
    cursor: Cursor,
  },
  { additionalProperties: false },
);

export type SlackSearchInput = Static<typeof SlackSearchParams>;
export type SlackReadChannelInput = Static<typeof SlackReadChannelParams>;
export type SlackReadThreadInput = Static<typeof SlackReadThreadParams>;
export type SlackSearchUsersInput = Static<typeof SlackSearchUsersParams>;
