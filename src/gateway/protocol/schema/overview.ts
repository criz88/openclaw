import { Type } from "@sinclair/typebox";

export const OverviewSummaryParamsSchema = Type.Object({}, { additionalProperties: false });

export const OverviewSummaryResultSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    status: Type.Unknown(),
    usage: Type.Unknown(),
    cron: Type.Object(
      {
        status: Type.Unknown(),
        jobs: Type.Integer({ minimum: 0 }),
        disabled: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
