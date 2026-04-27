import { login } from '../src/auth.js'
test('login admin', () => { expect(login('admin', 'secret')).toBe(true) })
