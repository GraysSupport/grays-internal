import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import Dashboard from './pages/dashboard';
import Register from './pages/register';
import LandingPage from './pages/landingpage';
import Settings from './pages/settings';
import ProductsPage from './pages/products';
import CreateProductPage from './pages/products/create';
import EditProduct from './pages/products/edit';

function App() {
  return (
    <>
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            fontSize: '14px',
          },
        }}
      />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/register" element={<Register />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/products" element={<ProductsPage />} />
        <Route path="/products/create" element={<CreateProductPage />} />
        <Route path="/products/:sku/edit" element={<EditProduct />} />
      </Routes>
    </>
  );
}

export default App;
