import { Context } from 'hono'

export function problem(
  c: Context,
  status: number,
  type: string,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {}
) {
  return c.json(
    {
      type: `https://mac-graph/errors/${type}`,
      title,
      status,
      ...(detail ? { detail } : {}),
      instance: c.req.path,
      ...extra
    },
    status as 400 | 404 | 409 | 500 | 507
  )
}
