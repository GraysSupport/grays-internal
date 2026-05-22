// api/winnings.js
// Vercel serverless function — proxies Winnings SAP inventory API.
// All config lives in environment variables; nothing infrastructure-specific
// is hardcoded here so the public repo reveals nothing about the SAP endpoints.

export const FACILITY_NAMES = {
  '2000': 'NSW', '3000': 'VIC', '4000': 'QLD',
  '5000': 'SA',  '6000': 'WA',  '7000': 'TAS', '8000': 'NT',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey     = process.env.WINNINGS_API_KEY;
  const sapUser    = process.env.WINNINGS_SAP_USER;
  const sapPass    = process.env.WINNINGS_SAP_PASSWORD;
  const env        = (process.env.WINNINGS_ENV || 'QAS').toUpperCase();
  const baseQAS    = process.env.WINNINGS_SAP_BASE_QAS;
  const basePROD   = process.env.WINNINGS_SAP_BASE_PROD;

  // Validate all required env vars up front — fail loudly so misconfiguration
  // is obvious in Vercel logs rather than silently producing bad requests.
  const missing = [
    !apiKey   && 'WINNINGS_API_KEY',
    !sapUser  && 'WINNINGS_SAP_USER',
    !sapPass  && 'WINNINGS_SAP_PASSWORD',
    !baseQAS  && 'WINNINGS_SAP_BASE_QAS',
    !basePROD && 'WINNINGS_SAP_BASE_PROD',
  ].filter(Boolean);

  if (missing.length) {
    return res.status(500).json({
      error: `Winnings API not fully configured. Missing env vars: ${missing.join(', ')}`,
    });
  }

  const base = env === 'PROD' ? basePROD : baseQAS;

  const { facility, sku, includeZeroStock } = req.query;

  if (!facility) {
    return res.status(400).json({
      error: 'facility is required (e.g. ?facility=2000 for NSW)',
    });
  }

  // Build OData $filter string
  const filterParts = [`Facility eq '${facility}'`];
  if (sku)                          filterParts.push(`CustomerSKU eq '${sku}'`);
  if (includeZeroStock === 'true')  filterParts.push(`IncludeZeroStock eq 'X'`);

  const filterStr = filterParts.join(' and ');
  const url = `${base}/ZSD_INVENTORY_STOCK_SRV/InventoryStockSet?$filter=${encodeURIComponent(filterStr)}`;

  try {
    const sapRes = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'User':      sapUser,
        'Password':  sapPass,
        'Accept':    'application/json',
      },
    });

    const data = await sapRes.json().catch(() => ({}));

    if (!sapRes.ok) {
      const msg = data?.error?.message?.value || `SAP returned HTTP ${sapRes.status}`;
      return res.status(sapRes.status).json({ error: msg });
    }

    const results = Array.isArray(data?.d?.results) ? data.d.results : [];

    return res.status(200).json({
      results,
      facility,
      facilityName: FACILITY_NAMES[facility] || facility,
      env,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[winnings] fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to reach Winnings SAP API. Check server logs.' });
  }
}
