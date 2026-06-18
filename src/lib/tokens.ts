import { randomBytes, createHash } from "node:crypto";
export const mintToken = () => randomBytes(32).toString("base64url");
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
