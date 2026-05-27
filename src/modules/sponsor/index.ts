import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { SponsorService } from "./service";
import type { Address } from "viem";

const callSchema = t.Object({
  to: t.String(),
  value: t.String(),
  data: t.String(),
});

const tradeBodySchema = t.Object({
  authority: t.String(),
  calls: t.Array(callSchema),
  signature: t.String(),
});

export const sponsor = new Elysia({ prefix: "/sponsor" })
  .use(cors({ origin: true, credentials: false }))
  .post(
    "/trade",
    async ({ body, set }) => {
      try {
        const calls = body.calls.map((c) => ({
          to: c.to as Address,
          value: BigInt(c.value),
          data: c.data as `0x${string}`,
        }));

        const result = await SponsorService.trade(
          body.authority as Address,
          calls,
          body.signature as `0x${string}`
        );

        return result;
      } catch (err) {
        set.status = 400;
        return {
          error:
            err instanceof Error ? err.message : "sponsored trade failed",
        };
      }
    },
    { body: tradeBodySchema }
  );
