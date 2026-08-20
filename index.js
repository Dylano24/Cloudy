const PRIMARY_RAILWAY_PROJECT_ID = '0dae5cd5-d555-4150-bce8-44fca806bfb3';
const railwayProjectId = process.env.RAILWAY_PROJECT_ID || null;

if (railwayProjectId && railwayProjectId !== PRIMARY_RAILWAY_PROJECT_ID) {
  console.error(
    `[startup] Refusing to start Discord client from secondary Railway project ${railwayProjectId}. ` +
    `Primary Cloudy project is ${PRIMARY_RAILWAY_PROJECT_ID}.`
  );
  process.exit(0);
}

await import('./src/app.js');
