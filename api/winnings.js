// api/winnings.js
// Vercel serverless function — proxies Winnings SAP inventory API.
// Credentials live in env vars only; the browser never sees them.

const SAP_BASE = {
  QAS:  'https://winnings-sap-dev.apimanagement.ap10.hana.ondemand.com:443',
  PROD: 'https://winnings-sap.apimanagement.ap10.hana.ondemand.com:443',
};

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

  if (!apiKey || !sapUser || !sapPass) {
    return res.status(500).json({
      error: 'Winnings API credentials not configured. '
           + 'Set WINNINGS_API_KEY, WINNINGS_SAP_USER, and WINNINGS_SAP_PASSWORD in your environment.',
    });
  }

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
  const base = SAP_BASE[env] || SAP_BASE.QAS;
  const url  = `${base}/ZSD_INVENTORY_STOCK_SRV/InventoryStockSet?$filter=${encodeURIComponent(filterStr)}`;

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
