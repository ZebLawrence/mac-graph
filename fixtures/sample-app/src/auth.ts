export function login(user: string, pass: string): boolean {
  return user === 'admin' && pass === 'secret'
}
export function logout(): void { /* clear */ }
