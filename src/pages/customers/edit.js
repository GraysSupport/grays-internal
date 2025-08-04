import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../components/backbutton';

export default function EditCustomerPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState(null);

  useEffect(() => {
    const fetchCustomer = async () => {
      try {
        const res = await fetch(`/api/customers/${id}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to fetch customer');
        setForm(data);
      } catch (err) {
        toast.error(err.message);
      }
    };
    if (id) fetchCustomer();
  }, [id]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const toastId = toast.loading('Updating customer...');
    try {
      const res = await fetch(`/api/customers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      toast.dismiss(toastId);
      if (!res.ok) throw new Error(data.error || 'Update failed');
      toast.success('Customer updated!');
      navigate('/customers');
    } catch (err) {
      toast.error(err.message, { id: toastId });
    }
  };

  if (!form) return <div className="h-screen flex items-center justify-center">Loading...</div>;

  return (
    <div className="min-h-screen bg-gray-100 flex justify-center items-center p-6">
      <BackButton />
      <div className="bg-white p-6 rounded shadow-md w-full max-w-lg">
        <h2 className="text-xl font-bold mb-4 text-center">Edit Customer</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          {['name', 'email', 'phone', 'address', 'notes'].map((field) => (
            <input
              key={field}
              type="text"
              placeholder={field.charAt(0).toUpperCase() + field.slice(1)}
              className="border p-2 rounded w-full"
              value={form[field]}
              onChange={(e) => setForm({ ...form, [field]: e.target.value })}
            />
          ))}
          <button type="submit" className="w-full bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
            Save Changes
          </button>
        </form>
      </div>
    </div>
  );
}
