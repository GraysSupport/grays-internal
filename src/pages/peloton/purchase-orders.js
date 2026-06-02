// src/pages/peloton/purchase-orders.js
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { PackageSearch, Construction } from 'lucide-react';
import BackButton from '../../components/backbutton';
import HomeButton from '../../components/homebutton';
import PelotonTabs from '../../components/PelotonTabs';

export default function PurchaseOrdersPage() {
  const navigate = useNavigate();

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) { navigate('/'); return; }
    const u = JSON.parse(stored);
    if (u?.access !== 'superadmin') {
      toast.error('Insufficient permissions');
      navigate('/dashboard');
    }
  }, [navigate]);

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      <header className="bg-white shadow-md px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <BackButton />
        <HomeButton />
        <div className="flex items-center gap-2 ml-2">
          <span className="inline-flex items-center gap-1.5 bg-black text-white text-xs font-bold px-2.5 py-1 rounded-full tracking-wide">
            <PackageSearch size={13} />
            PELOTON
          </span>
          <h1 className="text-base font-semibold text-gray-800">Purchase Orders</h1>
        </div>
      </header>

      <main className="flex-1 overflow-auto flex flex-col items-center justify-center gap-4 text-gray-400">
        <Construction size={48} strokeWidth={1.3} />
        <p className="text-sm font-medium">Purchase Orders — coming soon</p>
        <p className="text-xs text-gray-300">This section is under construction.</p>
      </main>

      <PelotonTabs />
    </div>
  );
}
