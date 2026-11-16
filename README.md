# Retail Demand Forecasting Dashboard

This project contains:
- `frontend/`: static dashboard for Netlify
- `backend/`: FastAPI service for Render
- `backend/models/`: Stage 3.6 trained model artifact and metadata
- `backend/data/`: daily aggregate demand derived from the uploaded `retail_store_inventory.csv`

## Deployment order

### 1. Deploy backend to Render
1. Push this project folder to a GitHub repository.
2. In Render, create a new **Blueprint** or **Web Service** from that repository.
3. If creating a Web Service manually, set:
   - Root Directory: `backend`
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Wait for deployment. Test `https://YOUR-RENDER-SERVICE.onrender.com/health`.
5. API documentation: `https://YOUR-RENDER-SERVICE.onrender.com/docs`.

`requirements.txt` pins scikit-learn to 1.6.1 to match the model artifact's training environment. Do not casually upgrade scikit-learn when loading the joblib file.

### 2. Connect the Netlify frontend
1. Open `frontend/config.js`.
2. Replace `https://YOUR-RENDER-SERVICE.onrender.com` with your actual Render service URL.
3. Push the change to GitHub.
4. In Netlify, import the same GitHub repository.
5. Set Base directory to `frontend`; Publish directory to `.`; no build command is required.
6. Deploy.

### 3. Test
- `GET /health`
- `GET /history?days=90`
- `GET /model-info`
- `POST /forecast/7-days` with body `{}`
- `POST /forecast/30-days` with body `{}`

The dashboard loads historical data and forecasts from the FastAPI backend.

## Forecasting details and limitations
- Forecast target: daily total `Units Sold` aggregated across all stores and products.
- 7-day model: Random Forest.
- 30-day model: Extra Trees.
- Both models use the same Stage 3.6 recursive feature logic and 12 calendar/lag features.
- The included CSV history ends on 2024-01-01 and is synthetic. Default forecasts are a demonstration from that historical endpoint, not live 2026 retail forecasts.
- Rolling-origin mean R² values were negative in Stage 3.6. The dashboard reports this limitation rather than describing R² as accuracy.
- For forecasts from newer operational data, send at least 28 consecutive daily aggregate demand values and the corresponding `last_date` in the POST body. The service uses the last 28 values as the forecasting context.

## API request example with user-supplied recent history
```json
{
  "history": [12000, 12500, 13000, 12800, 12700, 12900, 13100, 12600, 12500, 12800, 13000, 13200, 12900, 12800, 12700, 13100, 13300, 12900, 12800, 13000, 13200, 13400, 13100, 12900, 12800, 13000, 13200, 13300],
  "last_date": "2026-11-15"
}
```
