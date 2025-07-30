import { Link } from 'react-router-dom';

export default function LandingPage() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <div className="bg-white p-10 rounded shadow-md text-center space-y-6">
        <h1 className="text-3xl font-bold text-gray-800">Welcome to Grays Admin Portal</h1>
        <p className="text-gray-600">Please choose an option below to continue:</p>
        <div className="flex justify-center space-x-4">
          <Link to="/login">
            <button className="bg-blue-500 text-white px-6 py-2 rounded hover:bg-blue-600 transition">
              Login
            </button>
          </Link>
          <Link to="/register">
            <button className="bg-gray-500 text-white px-6 py-2 rounded hover:bg-gray-600 transition">
              Register
            </button>
          </Link>
        </div>
      </div>
    </div>
  );
}
