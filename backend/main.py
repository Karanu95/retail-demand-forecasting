from pathlib import Path
from datetime import timedelta
import json
import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models"
DATA_DIR = ROOT / "data"

with open(MODEL_DIR / "metadata.json", "r", encoding="utf-8") as f:
    METADATA = json.load(f)

MODELS = joblib.load(MODEL_DIR / "aggregate_models.joblib")
HISTORY_DF = pd.read_csv(DATA_DIR / "daily_aggregate_demand.csv", parse_dates=["Date"])
HISTORY_DF = HISTORY_DF.sort_values("Date").drop_duplicates("Date").reset_index(drop=True)

FEATURES = METADATA["features"]
SELECTED = METADATA["selected_models"]
DATASET_END = HISTORY_DF["Date"].max()

app = FastAPI(
    title="Retail Demand Forecasting API",
    description="Aggregate daily retail demand forecasting using Stage 3.6 selected models.",
    version="1.0.0"
)

# Restrict this list to your deployed Netlify site URL after deployment.
# For initial testing, '*' permits local frontend previews.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ForecastRequest(BaseModel):
    # Optional user-supplied latest daily aggregate demand history.
    # If omitted, the API uses the included synthetic dataset through 2024-01-01.
    history: Optional[List[float]] = Field(
        default=None,
        min_length=28,
        description="At least 28 consecutive daily aggregate Units Sold values, oldest first."
    )
    last_date: Optional[str] = Field(
        default=None,
        description="Date corresponding to the final history value, YYYY-MM-DD."
    )

def feature_row(history_values, date):
    vals = np.asarray(history_values, dtype=float)
    if len(vals) < 28:
        raise ValueError("At least 28 historical daily observations are required.")
    doy = date.timetuple().tm_yday
    row = {
        "DayOfWeek": date.weekday(),
        "Day": date.day,
        "Month": date.month,
        "DayOfYear": doy,
        "DayOfYearSin": np.sin(2 * np.pi * doy / 365.25),
        "DayOfYearCos": np.cos(2 * np.pi * doy / 365.25),
        "Lag_1": vals[-1],
        "Lag_7": vals[-7],
        "Lag_14": vals[-14],
        "Lag_28": vals[-28],
        "RollingMean_7": vals[-7:].mean(),
        "RollingMean_28": vals[-28:].mean(),
    }
    return pd.DataFrame([row], columns=FEATURES)

def prepare_history(request: Optional[ForecastRequest]):
    if request and request.history is not None:
        vals = request.history
        if any((not np.isfinite(v)) or v < 0 for v in vals):
            raise HTTPException(status_code=422, detail="History values must be finite and non-negative.")
        if not request.last_date:
            raise HTTPException(status_code=422, detail="last_date is required when history is supplied.")
        try:
            last_date = pd.Timestamp(request.last_date).to_pydatetime().date()
        except Exception:
            raise HTTPException(status_code=422, detail="last_date must use YYYY-MM-DD format.")
        return list(map(float, vals[-28:])), last_date, "user_supplied"
    vals = HISTORY_DF["Units Sold"].astype(float).tolist()
    return vals[-28:], DATASET_END.date(), "included_dataset_demo"

def make_forecast(horizon: int, request: Optional[ForecastRequest]):
    history, last_date, source = prepare_history(request)
    model_key = "7-Day" if horizon == 7 else "30-Day"
    model = MODELS.get(model_key)
    model_name = SELECTED[model_key]
    preds = []
    dates = []
    rolling_history = list(history)

    for step in range(1, horizon + 1):
        date = last_date + timedelta(days=step)
        X = feature_row(rolling_history, date)
        value = float(model.predict(X)[0])
        value = max(0.0, value)
        preds.append(round(value, 2))
        dates.append(date.isoformat())
        rolling_history.append(value)

    return {
        "horizon_days": horizon,
        "target": "Aggregate daily Units Sold across all stores and products",
        "model": model_name,
        "history_source": source,
        "history_last_date": last_date.isoformat(),
        "forecast_start": dates[0],
        "forecast_end": dates[-1],
        "total_predicted_units": round(float(sum(preds)), 2),
        "average_daily_predicted_units": round(float(np.mean(preds)), 2),
        "predictions": [
            {"date": d, "predicted_units": p}
            for d, p in zip(dates, preds)
        ],
        "notice": "Demo history is synthetic and ends on 2024-01-01. Forecasts from the included dataset are not live 2026 retail predictions."
    }

@app.get("/")
def root():
    return {
        "project": METADATA["project"],
        "status": "running",
        "docs": "/docs",
        "forecast_horizons": [7, 30]
    }

@app.get("/health")
def health():
    return {
        "status": "healthy",
        "models_loaded": all(MODELS.get(k) is not None for k in ["7-Day", "30-Day"]),
        "dataset_start": str(HISTORY_DF["Date"].min().date()),
        "dataset_end": str(DATASET_END.date())
    }

@app.get("/model-info")
def model_info():
    return {
        "selected_models": SELECTED,
        "rolling_validation_metrics": METADATA.get("rolling_validation_mean_metrics", []),
        "previously_inspected_holdout_metrics": METADATA.get("previously_inspected_holdout_metrics", []),
        "features": FEATURES,
        "dataset_period": {
            "start": str(HISTORY_DF["Date"].min().date()),
            "end": str(DATASET_END.date())
        },
        "caveat": METADATA.get("caveat")
    }

@app.get("/history")
def history(days: int = 90):
    if days < 7 or days > len(HISTORY_DF):
        raise HTTPException(status_code=400, detail=f"days must be between 7 and {len(HISTORY_DF)}.")
    frame = HISTORY_DF.tail(days)
    return {
        "target": "Aggregate daily Units Sold",
        "records": [
            {"date": row.Date.date().isoformat(), "actual_units": float(row["Units Sold"])}
            for _, row in frame.iterrows()
        ]
    }

@app.post("/forecast/7-days")
def forecast_7_days(request: Optional[ForecastRequest] = None):
    return make_forecast(7, request)

@app.post("/forecast/30-days")
def forecast_30_days(request: Optional[ForecastRequest] = None):
    return make_forecast(30, request)
