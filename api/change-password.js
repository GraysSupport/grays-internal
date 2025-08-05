import { compare, hash } from 'bcryptjs';
import { getClientWithTimezone } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const client = await getClientWithTimezone();
  const { email, oldPassword, newPassword } = req.body;

  try {
    const result = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = result.rows[0];
    const isValid = await compare(oldPassword, user.password);
    if (!isValid) return res.status(401).json({ error: 'Incorrect old password' });

    const hashed = await hash(newPassword, 10);
    await client.query('UPDATE users SET password = $1 WHERE email = $2', [hashed, email]);

    // Log access event
    await client.query(
      'INSERT INTO access_log (user_id, description) VALUES ($1, $2)',
      [user.id, 'User changed password']
    );

    return res.status(200).json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to change password' });
  }
}
