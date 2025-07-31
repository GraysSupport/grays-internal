import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export default function BackButton() {
  const navigate = useNavigate();

  return (
    <button
      onClick={() => navigate(-1)}
      className="fixed top-4 left-4 z-50 p-2 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-800 shadow transition"
      aria-label="Go back"
    >
      <ArrowLeft size={20} />
    </button>
  );
}
