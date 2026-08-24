import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Dates are rendered in one place, for one audience, in one zone.
    //
    // `toLocaleString("en-US")` in the DM log turned 00:30 into "12:30 AM"
    // and an entry from just after midnight was read as midday. The locale
    // and the zone must never again be left to whichever machine runs the
    // code — lib/utils/datetime pins both.
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "worker/**/*.ts"],
    ignores: ["lib/utils/datetime.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression > MemberExpression[property.name=/^toLocale(String|DateString|TimeString)$/]",
          message:
            "Locale and time zone must be explicit: use the helpers in lib/utils/datetime (formatDateTime, formatDate, formatTime, formatNumber, …).",
        },
        {
          selector:
            "NewExpression[callee.name='Date'][arguments.length>=2]",
          message:
            "new Date(year, month, …) uses the process time zone, which is UTC in our containers. Use startOfDay/startOfMonth/addDays from lib/utils/datetime.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
