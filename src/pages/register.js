import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import BackButton from '../components/backbutton';
import HomeButton from '../components/homebutton';
import toast from 'react-hot-toast';
import { authHeaders, getToken, getRoles, hasAnyRole } from '../utils/auth';

// F0b: single-user-multi-role. Keep in sync with lib/rbac.js ROLES (precedence order).
// users.access mirrors the primary (highest-precedence) role server-side.
const ROLES = ['superadmin', 'admin', 'logistics', 'sales', 'staff', 'technician', 'workshop'];

// F9: user administration (create/edit/delete + role assignment) is superadmin-only.
// This check is DISPLAY-ONLY — the server re-verifies every write against the login JWT.
const ADMIN_ROLES = ['superadmin'];

function RoleCheckboxes({ selected, onToggle }) {
  const set = new Set(selected || []);
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {ROLES.map((role) => (
        <label key={role} className="inline-flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={set.has(role)}
            onChange={() => onToggle(role)}
          />
          {role}
        </label>
      ))}
    </div>
  );
}

export default function Register() {
  const [activeTab, setActiveTab] = useState('register');
  const [form, setForm] = useState({
    id: '',
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    roles: ['staff'],
  });
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  const navigate = useNavigate();

  // F9: superadmin-only. Reads the role SET signed into the login JWT (P10) rather than
  // the single localStorage `user.access`, so an admin who holds superadmin alongside
  // other roles is judged on the same set the server gates on. Display-only — every
  // write is re-checked server-side against the JWT.
  useEffect(() => {
    if (!getToken()) { navigate('/'); return; }
    if (!hasAnyRole(getRoles(), ADMIN_ROLES)) {
      toast.error('User administration is for superadmins');
      navigate('/dashboard');
      return;
    }
    setAuthorized(true);
  }, [navigate]);

  const handleChange = (e) =>
    setForm({ ...form, [e.target.name]: e.target.value });

  const toggleFormRole = (role) =>
    setForm((f) => {
      const set = new Set(f.roles);
      if (set.has(role)) set.delete(role);
      else set.add(role);
      return { ...f, roles: ROLES.filter((r) => set.has(r)) };
    });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    if (!form.roles.length) {
      toast.error('Select at least one role');
      return;
    }

    const { confirmPassword, ...formData } = form;
    const registerToast = toast.loading('Registering user...');

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
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
          roles: ['staff'],
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
      const res = await fetch('/api/users', { headers: authHeaders() });
      if (!res.ok) throw new Error('Failed to fetch users');
      const data = await res.json();
      // Ensure every row has a roles array (falls back to [access]).
      const normalised = (Array.isArray(data) ? data : []).map((u) => ({
        ...u,
        roles: Array.isArray(u.roles) && u.roles.length ? u.roles : u.access ? [u.access] : [],
      }));
      setUsers(normalised);
    } catch {
      toast.error('Failed to fetch users');
      setUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  };

  const toggleUserRole = (userId, role) =>
    setUsers((prev) =>
      prev.map((u) => {
        if (u.id !== userId) return u;
        const set = new Set(u.roles || []);
        if (set.has(role)) set.delete(role);
        else set.add(role);
        return { ...u, roles: ROLES.filter((r) => set.has(r)) };
      })
    );

  const handleUpdate = async (row) => {
    if (!row.roles?.length) {
      toast.error('Select at least one role');
      return;
    }
    const updateToast = toast.loading('Updating user...');
    try {
      const res = await fetch('/api/users', {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
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
    if (authorized && activeTab === 'update') fetchUsers();
  }, [authorized, activeTab]);

  // Don't paint the user-admin UI before the role check has passed (mirrors /leads).
  if (!authorized) return null;

  return (
    <>
      <div className="fixed top-4 left-6 z-50 flex gap-2">
        <HomeButton />
        <BackButton />
      </div>
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
              <div className="mb-4">
                <p className="text-sm font-semibold mb-1">Roles</p>
                <RoleCheckboxes selected={form.roles} onToggle={toggleFormRole} />
                <p className="text-xs text-gray-500 mt-1">
                  The highest-privilege role becomes the user's primary access level.
                </p>
              </div>
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
                        <th className="border px-4 py-2">Roles</th>
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
                            <RoleCheckboxes
                              selected={u.roles}
                              onToggle={(role) => toggleUserRole(u.id, role)}
                            />
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
