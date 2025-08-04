import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BackButton from '../components/backbutton';
import toast from 'react-hot-toast';

export default function Settings() {
  const [user, setUser] = useState(null);
  const [form, setForm] = useState({ oldPassword: '', newPassword: '', confirmPassword: '' });
  const navigate = useNavigate();

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) {
      navigate('/');
      return;
    }
    setUser(JSON.parse(stored));
  }, [navigate]);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.newPassword !== form.confirmPassword) {
      toast.error('New passwords do not match');
      return;
    }

    const toastId = toast.loading('Updating password...');
    try {
      const res = await fetch('/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          oldPassword: form.oldPassword,
          newPassword: form.newPassword,
        }),
      });

      const data = await res.json();
      toast.dismiss(toastId);

      if (res.ok) {
        toast.success(data.message || 'Password updated');
      } else {
        toast.error(data.error || 'Password update failed');
      }
    } catch (err) {
      toast.dismiss(toastId);
      toast.error('Server error');
    }
  };

  return (
    <>
      <BackButton />
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-6 rounded shadow-md w-full max-w-md">
          <h2 className="text-2xl font-bold mb-4 text-center">User Settings</h2>
          {user && (
            <div className="mb-6 text-sm text-gray-700 space-y-1">
              <p><strong>Name:</strong> {user.name}</p>
              <p><strong>Email:</strong> {user.email}</p>
              <p><strong>ID:</strong> {user.id}</p>
            </div>
          )}
          <form onSubmit={handleSubmit}>
            {['oldPassword', 'newPassword', 'confirmPassword'].map((field, i) => (
              <input
                key={i}
                type="password"
                name={field}
                placeholder={field.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}
                value={form[field]}
                onChange={handleChange}
                className="w-full mb-4 px-4 py-2 border rounded"
                required
              />
            ))}
            <button type="submit" className="w-full bg-blue-500 text-white py-2 rounded hover:bg-blue-600">
              Change Password
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
