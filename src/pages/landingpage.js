import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

export default function LandingPage() {
  const [form, setForm] = useState({ email: '', password: '' });
  const navigate = useNavigate();

  const handleChange = (e) =>
    setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    const loginToast = toast.loading('Logging in...');

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      const data = await res.json();
      toast.dismiss(loginToast);

      if (res.ok) {
        const expiryTime = Date.now() + 30 * 60 * 1000; // 30 minutes
        localStorage.setItem('token', data.token);
        localStorage.setItem(
          'user',
          JSON.stringify({
            id: data.id,
            name: data.name,
            email: data.email,
            access: data.access,
          })
        );
        localStorage.setItem('sessionExpiry', expiryTime.toString());

        toast.success('Login successful!');
        navigate('/dashboard');
      } else {
        toast.error(data.error || 'Login failed');
      }
    } catch (err) {
      toast.dismiss(loginToast);
      toast.error('Server error');
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <div className="bg-white p-10 rounded shadow-md text-center space-y-6">
        <h1 className="text-3xl font-bold text-gray-800">Welcome to Grays Admin Portal</h1>
        <p className="text-gray-600">Please Login to Continue</p>
        <form
          className="bg-white p-6 rounded shadow-md w-full max-w-md"
          onSubmit={handleSubmit}
        >
          {['email', 'password'].map((field) => (
            <input
              key={field}
              type={field === 'password' ? 'password' : 'text'}
              name={field}
              placeholder={field.charAt(0).toUpperCase() + field.slice(1)}
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
            Login
          </button>
        </form>
      </div>
    </div>
  );
}
