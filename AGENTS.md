<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Dates, times and numbers

The dashboard is read by a German audience; the containers run this code in
UTC. Both facts have to be stated in the code, never inherited from the
machine — `toLocaleString("en-US")` once turned a 00:30 log entry into
"12:30 AM", which was read as midday, and UTC day boundaries put everything
between midnight and 02:00 into the previous day.

Use `lib/utils/datetime`:

- rendering — `formatDateTime`, `formatDateTimeShort`, `formatDate`,
  `formatDateShort`, `formatTime`, `formatDayLabel`, `formatWeekdayShort`,
  `formatNumber`
- day and month boundaries, day arithmetic — `startOfDay`, `startOfMonth`,
  `addDays`, `toDateKey`

`toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` and
`new Date(year, month, …)` are ESLint errors outside that module. Timestamps
stay UTC in the database; only the edges convert. The test suite runs in UTC
(`vitest.config.ts`) so a zone bug cannot hide on a machine that already sits
in Berlin.
