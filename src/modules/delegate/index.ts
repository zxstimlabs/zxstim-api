import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { DelegateService } from "./service";

const authorizationSchema = t.Object({
  address: t.String(),
  chainId: t.Number(),
  nonce: t.Number(),
  r: t.String(),
  s: t.String(),
  yParity: t.Number(),
});

const bodySchema = t.Object({
  authorization: authorizationSchema,
  authority: t.String(),
});

export const delegate = new Elysia({ prefix: "/delegate" })
  .use(cors({ origin: true, credentials: false }))
  .post(
    "/arbitrum-sepolia",
    async ({ body, set }) => {
      try {
        const authorization = {
          address: body.authorization.address as `0x${string}`,
          chainId: body.authorization.chainId,
          nonce: body.authorization.nonce,
          r: body.authorization.r as `0x${string}`,
          s: body.authorization.s as `0x${string}`,
          yParity: body.authorization.yParity,
        };

        const result = await DelegateService.delegate(
          authorization,
          body.authority as `0x${string}`
        );

        return result;
      } catch (err) {
        set.status = 400;
        return {
          error: err instanceof Error ? err.message : "delegation failed",
        };
      }
    },
    { body: bodySchema }
  );
