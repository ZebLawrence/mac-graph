import { login } from './auth.js'
export async function authenticate(req: { user: string; pass: string }): Promise<{ ok: boolean }> { return { ok: login(req.user, req.pass) } }
