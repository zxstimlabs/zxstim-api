import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import type { Address } from "viem";
import { ClaimService } from "./service";

const bodySchema = t.Object({
  requester: t.String(),
  tokens: t.Array(t.String(), { minItems: 1 }),
  nonce: t.Number(),
  signature: t.String(),
});

export const claim = new Elysia({ prefix: "/claim" })
  .use(cors({ origin: true, credentials: false }))
  .post(
    "/mock-tokens",
    async ({ body, set }) => {
      try {
        const result = await ClaimService.claim({
          requester: body.requester as Address,
          tokens: body.tokens as Address[],
          nonce: body.nonce,
          signature: body.signature as `0x${string}`,
        });

        return { transfers: result };
      } catch (err) {
        set.status = 400;
        return {
          error: err instanceof Error ? err.message : "claim failed",
        };
      }
    },
    { body: bodySchema }
  );
