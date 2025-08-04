import { useEffect, useState } from 'react';

export default function ProductForm({ initialValues, onSubmit, submitLabel = 'Save' }) {
  const [form, setForm] = useState(initialValues || {
    sku: '',
    brand: '',
    name: '',
    stock: '',
    price: '',
  });
  const [brands, setBrands] = useState([]);

  useEffect(() => {
    if (initialValues) setForm(initialValues);
  }, [initialValues]);

  useEffect(() => {
    fetch('/api/brands')
      .then(res => res.json())
      .then(data => setBrands(data))
      .catch(() => setBrands([]));
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({
      ...form,
      stock: parseInt(form.stock),
      price: parseFloat(form.price),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <input
        type="text"
        name="sku"
        placeholder="SKU"
        value={form.sku}
        onChange={handleChange}
        className="w-full px-3 py-2 border rounded"
        required
        disabled={!!initialValues?.sku} // prevent editing SKU on update
      />
      <input
        type="text"
        name="name"
        placeholder="Name"
        value={form.name}
        onChange={handleChange}
        className="w-full px-3 py-2 border rounded"
        required
      />
      <select
        name="brand"
        value={form.brand}
        onChange={handleChange}
        className="w-full px-3 py-2 border rounded"
        required
      >
        <option value="">Select Brand</option>
        {brands.map((b) => (
          <option key={b.brand_id} value={b.brand_id}>
            {b.brand_name}
          </option>
        ))}
      </select>
      <input
        type="number"
        name="stock"
        placeholder="Stock"
        value={form.stock}
        onChange={handleChange}
        className="w-full px-3 py-2 border rounded"
        required
      />
      <input
        type="number"
        step="0.01"
        name="price"
        placeholder="Price"
        value={form.price}
        onChange={handleChange}
        className="w-full px-3 py-2 border rounded"
        required
      />
      <button
        type="submit"
        className="bg-blue-500 text-white w-full py-2 rounded hover:bg-blue-600"
      >
        {submitLabel}
      </button>
    </form>
  );
}
