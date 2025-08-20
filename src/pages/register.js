import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import BackButton from '../components/backbutton';
import toast from 'react-hot-toast';

export default function Register() {
  const [activeTab, setActiveTab] = useState('register');
  const [form, setForm] = useState({
    id: '',
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  const navigate = useNavigate();

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) {
      navigate('/');
      return;
    }
    const u = JSON.parse(stored);
    if (u?.access !== 'superadmin') {
      toast.error('Insufficient permissions');
      navigate('/dashboard');
    }
  }, [navigate]);

  const handleChange = (e) =>
    setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }

    const { confirmPassword, ...formData } = form;
    const registerToast = toast.loading('Registering user...');

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await res.json();
      toast.dismiss(registerToast);

      if (res.ok) {
        toast.success(data.message || 'User registered');
        setForm({
          id: '',
          name: '',
          email: '',
          password: '',
          confirmPassword: '',
        });
      } else {
        toast.error(data.error || 'Registration failed');
      }
    } catch {
      toast.dismiss(registerToast);
      toast.error('Server error');
    }
  };

  const fetchUsers = async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch('/api/users');
      if (!res.ok) throw new Error('Failed to fetch users');
      const data = await res.json();
      setUsers(Array.isArray(data) ? data : []);
    } catch {
      toast.error('Failed to fetch users');
      setUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  };

  const handleUpdate = async (row) => {
    const updateToast = toast.loading('Updating user...');
    try {
      const res = await fetch('/api/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
      });

      const data = await res.json();
      toast.dismiss(updateToast);
      if (res.ok) {
        toast.success(data.message || 'User updated');
        fetchUsers();
      } else {
        toast.error(data.error || 'Update failed');
      }
    } catch {
      toast.dismiss(updateToast);
      toast.error('Update error');
    }
  };

  useEffect(() => {
    if (activeTab === 'update') fetchUsers();
  }, [activeTab]);

  const accessLevels = ['superadmin', 'admin', 'staff', 'technician', 'it-technician'];

  return (
    <>
      <BackButton />
      <div className="flex justify-center mt-6">
        <button
          onClick={() => setActiveTab('register')}
          className={`px-4 py-2 rounded-t ${activeTab === 'register' ? 'bg-gray-300 text-gray-700' : 'bg-white text-blue-500 font-bold'}`}
        >
          Register
        </button>
        <button
          onClick={() => setActiveTab('update')}
          className={`px-4 py-2 rounded-t ${activeTab === 'update' ? 'bg-gray-300 text-gray-700' : 'bg-white text-blue-500 font-bold'}`}
        >
          Update Users
        </button>
      </div>

      <div className="flex items-center justify-center bg-gray-100 min-h-screen pt-0">
        <div className="bg-white p-6 rounded shadow-md w-full max-w-6xl mt-0">
          {activeTab === 'register' && (
            <form onSubmit={handleSubmit}>
              <h2 className="text-2xl font-bold mb-4 text-center">Register</h2>
              {['id', 'name', 'email', 'password', 'confirmPassword'].map((field) => (
                <input
                  key={field}
                  type={field.toLowerCase().includes('password') ? 'password' : 'text'}
                  name={field}
                  placeholder={field === 'confirmPassword' ? 'Confirm Password' : field.charAt(0).toUpperCase() + field.slice(1)}
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
            </form>
          )}

          {activeTab === 'update' && (
            <div>
              <h2 className="text-2xl font-bold mb-4 text-center">Update Users</h2>
              {loadingUsers ? (
                <p className="text-center text-gray-500">Loading users...</p>
              ) : users.length === 0 ? (
                <p className="text-center">No users found.</p>
              ) : (
                <div className="overflow-auto">
                  <table className="w-full table-auto border-collapse border border-gray-300">
                    <thead>
                      <tr className="bg-gray-200">
                        <th className="border px-4 py-2">ID</th>
                        <th className="border px-4 py-2">Name</th>
                        <th className="border px-4 py-2">Email</th>
                        <th className="border px-4 py-2">Access Level</th>
                        <th className="border px-4 py-2">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.id}>
                          <td className="border px-4 py-2">{u.id}</td>
                          <td className="border px-4 py-2">
                            <input
                              type="text"
                              className="w-full px-2 py-1 border rounded"
                              value={u.name}
                              onChange={(e) =>
                                setUsers(users.map((x) => (x.id === u.id ? { ...x, name: e.target.value } : x)))
                              }
                            />
                          </td>
                          <td className="border px-4 py-2">
                            <input
                              type="email"
                              className="w-full px-2 py-1 border rounded"
                              value={u.email}
                              onChange={(e) =>
                                setUsers(users.map((x) => (x.id === u.id ? { ...x, email: e.target.value } : x)))
                              }
                            />
                          </td>
                          <td className="border px-4 py-2">
                            <select
                              className="w-full px-2 py-1 border rounded"
                              value={u.access}
                              onChange={(e) =>
                                setUsers(users.map((x) => (x.id === u.id ? { ...x, access: e.target.value } : x)))
                              }
                            >
                              {accessLevels.map((level) => (
                                <option key={level} value={level}>
                                  {level}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="border px-4 py-2 text-center">
                            <button
                              onClick={() => handleUpdate(u)}
                              className="bg-green-500 text-white px-4 py-1 rounded hover:bg-green-600"
                            >
                              Save
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}