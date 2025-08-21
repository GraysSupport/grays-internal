import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../components/backbutton';
import HomeButton from '../../components/homebutton';
import { parseMaybeJson } from '../../utils/http';

export default function EditCustomerPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState(null);

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) {
      navigate('/');
      return;
    }
    (async () => {
      try {
        if (!id) throw new Error('Missing customer ID in URL');
        const res = await fetch(`/api/customers?id=${encodeURIComponent(id)}`);
        const data = await parseMaybeJson(res);
        if (!res.ok) {
          const msg = data?.error || data?.raw || `HTTP ${res.status} fetching customer`;
          throw new Error(msg);
        }
        setForm(data);
      } catch (err) {
        toast.error(err.message);
        navigate('/customers');
      }
    })();
  }, [navigate, id]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const toastId = toast.loading('Updating customer...');
    try {
      const res = await fetch(`/api/customers?id=${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await parseMaybeJson(res);
      toast.dismiss(toastId);
      if (!res.ok) {
        const msg = data?.error || data?.raw || 'Update failed';
        throw new Error(msg);
      }
      toast.success('Customer updated!');
      navigate('/customers');
    } catch (err) {
      toast.error(err.message, { id: toastId });
    }
  };

  if (!form) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="text-lg font-medium text-gray-600">Loading…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="fixed top-4 left-6 z-50 flex gap-2">
        <HomeButton />
        <BackButton />
      </div>
      <div className="bg-white p-6 rounded shadow-md w-full max-w-lg mx-auto">
        <h2 className="text-xl font-bold mb-4 text-center">Edit Customer</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          {['name', 'email', 'phone', 'address', 'notes'].map((field) => (
            <input
              key={field}
              type={field === 'email' ? 'email' : 'text'}
              placeholder={field.charAt(0).toUpperCase() + field.slice(1)}
              className="border p-2 rounded w-full"
              value={form[field] ?? ''}
              onChange={(e) => setForm({ ...form, [field]: e.target.value })}
            />
          ))}
          <button
            type="submit"
            className="w-full bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
          >
            Save Changes
          </button>
        </form>
      </div>
    </div>
  );
}
