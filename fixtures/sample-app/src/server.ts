import { authenticate } from './api.js'
export async function handle(req: { user: string; pass: string }): Promise<Response> {
  const result = await authenticate(req)
  return new Response(JSON.stringify(result))
}
