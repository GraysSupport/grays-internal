import { useState } from 'react';
import BackButton from '../components/backbutton';

export default function Register() {
  const [form, setForm] = useState({
    id: '',
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [message, setMessage] = useState('');

  const handleChange = (e) =>
    setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      setMessage("Passwords do not match.");
      return;
    }

    const { confirmPassword, ...formData } = form; // Remove confirmPassword before sending

    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });

    const data = await res.json();
    setMessage(data.message || data.error);
  };

  return (
    <>
      <BackButton />
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <form
          className="bg-white p-6 rounded shadow-md w-full max-w-md"
          onSubmit={handleSubmit}
        >
          <h2 className="text-2xl font-bold mb-4 text-center">Register</h2>
          {['id', 'name', 'email', 'password', 'confirmPassword'].map((field) => (
            <input
              key={field}
              type={field.toLowerCase().includes('password') ? 'password' : 'text'}
              name={field}
              placeholder={
                field === 'confirmPassword'
                  ? 'Confirm Password'
                  : field.charAt(0).toUpperCase() + field.slice(1)
              }
              value={form[field]}
              onChange={handleChange}
              className="w-full mb-4 px-4 py-2 border rounded"
              required
            />
          ))}
          <button
            type="submit"
            className="w-full bg-blue-500 text-white py-2 rounded hover:bg-blue-600"
          >
            Register
          </button>
          <p className="mt-4 text-center text-sm text-red-500">{message}</p>
        </form>
      </div>
    </>
    
  );
}