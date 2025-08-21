import { useNavigate } from 'react-router-dom';
import { Home } from 'lucide-react';

export default function HomeButton() {
  const navigate = useNavigate();

  return (
    <button
      onClick={() => navigate('/dashboard')}
      className="p-2 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-800 shadow transition"
      aria-label="Go home"
    >
      <Home size={20} />
    </button>
  );
}
