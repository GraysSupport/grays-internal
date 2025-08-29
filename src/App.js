import React, { useEffect } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import Dashboard from './pages/dashboard';
import Register from './pages/register';
import LandingPage from './pages/landingpage';
import Settings from './pages/settings';

import ProductsPage from './pages/products';
import EditProduct from './pages/products/edit';

import CustomersPage from './pages/customers';
import EditCustomerPage from './pages/customers/edit';

import WaitlistPage from './pages/waitlist';
import CreateWaitlistPage from './pages/waitlist/create';

import CreateWorkorderPage from './pages/create_workorder';
import ActiveWorkordersPage from './pages/delivery_operations';
import WorkorderDetailPage from './pages/delivery_operations/workorder/[id]';
import CompletedOperationsPage from './pages/delivery_operations/completed-operations';

import ToBeBookedDeliveriesPage from './pages/delivery_operations/to-be-booked';
import DeliverySchedulePage from './pages/delivery_operations/schedule';
import CompletedDeliveriesPage from './pages/delivery_operations/completed-deliveries';

import CurrentCollectionsPage from './pages/delivery_operations/current-collections';
import CompletedCollectionsPage from './pages/delivery_operations/completed-collections';

function App() {
  const navigate = useNavigate();

  useEffect(() => {
    const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

    const checkSession = () => {
      const expiry = parseInt(localStorage.getItem('sessionExpiry'), 10);
      if (!expiry || Date.now() > expiry) {
        logout();
      }
    };

    const logout = async () => {
      const user = JSON.parse(localStorage.getItem('user'));
      if (user) {
        await fetch('/api/access-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: user.id,
            description: 'Session expired due to inactivity',
          }),
        });
      }

      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('sessionExpiry');
      navigate('/');
    };

    const resetSession = () => {
      const newExpiry = Date.now() + SESSION_TIMEOUT;
      localStorage.setItem('sessionExpiry', newExpiry.toString());
    };

    // Check session every 5 seconds
    const interval = setInterval(checkSession, 5000);

    // Reset session expiry on user activity
    const events = ['mousemove', 'keydown', 'click'];
    events.forEach((event) => window.addEventListener(event, resetSession));

    return () => {
      clearInterval(interval);
      events.forEach((event) => window.removeEventListener(event, resetSession));
    };
  }, [navigate]);

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
        <Route path="/products/:sku/edit" element={<EditProduct />} />

        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/customers/:id/edit" element={<EditCustomerPage />} />

        <Route path="/waitlist" element={<WaitlistPage />} />
        <Route path="/waitlist/create" element={<CreateWaitlistPage />} />

        <Route path="/create_workorder" element={<CreateWorkorderPage />} />
        <Route path="/delivery_operations" element={<ActiveWorkordersPage />} />
        <Route path="/delivery_operations/workorder/:id" element={<WorkorderDetailPage />} />
        <Route path="/delivery_operations/completed-operations" element={<CompletedOperationsPage />} />

        <Route path="delivery_operations/to-be-booked" element={<ToBeBookedDeliveriesPage />} />
        <Route path="delivery_operations/schedule" element={<DeliverySchedulePage />} />
        <Route path="delivery_operations/completed-deliveries" element={<CompletedDeliveriesPage />} />
        
        <Route path="delivery_operations/current-collections" element={<CurrentCollectionsPage />} />
        <Route path="delivery_operations/completed-collections" element={<CompletedCollectionsPage />} />

      </Routes>
    </>
  );
}

export default App;