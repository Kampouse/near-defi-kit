// Type shim for near-kit-qwik (optional peer). The real package ships raw
// TS source (exports ./src/index.ts); this keeps defi-kit typecheckable
// without installing it. Keep in sync with the wrapper's public surface.
declare module "near-kit-qwik" {
  export type NearConfig = { network: unknown; accountId?: string };
  export type Op = {
    kind: "call";
    contract: string;
    method: string;
    args: object;
    deposit?: string;
    gas?: string;
  };
  export function call(
    cfg: NearConfig,
    contractId: string,
    method: string,
    args: object,
    opts: { attachedDeposit?: string; gas?: string },
  ): Promise<unknown>;
  export function batch(cfg: NearConfig, ops: Op[]): Promise<unknown>;
  export function getSession(cfg: NearConfig): Promise<string | null>;
  export function connect(cfg: NearConfig): Promise<string>;
  export function disconnect(cfg: NearConfig): Promise<boolean>;
}
