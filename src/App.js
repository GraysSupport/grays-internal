import React, { useEffect } from 'react';
import logo from './logo.svg';

function App() {
  useEffect(() => {
    fetch('/api/users')
      .then(res => res.json())
      .then(data => console.log(data))
      .catch(error => console.error('Error fetching users:', error));
  }, []);

  return (
    <div className="text-center">
      <header className="bg-gray-900 min-h-screen flex flex-col items-center justify-center text-white">
        <img
          src={logo}
          className="h-40 motion-safe:animate-spin"
          alt="logo"
        />
        <p className="text-xl mt-4">
          Edit <code>src/App.js</code> and save to reload.
        </p>
        <a
          className="text-blue-400 underline mt-2"
          href="https://reactjs.org"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn React
        </a>
      </header>
    </div>
  );
}

export default App;