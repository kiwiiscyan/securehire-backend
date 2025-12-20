// src/config/swagger.ts
import swaggerJSDoc from "swagger-jsdoc";
const PROD_URL = process.env.PUBLIC_BASE_URL;

const options: swaggerJSDoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "SecureHire API",
      version: "1.0.0",
      description:
        "SecureHire backend for jobs, seeker identity and profile (MongoDB + Node.js)",
    },
    servers: [
      { url: "http://localhost:4000/api/v1", description: "Local dev" },
      ...(PROD_URL ? [{ url: `${PROD_URL}/api/v1`, description: "Production" }] : []),
    ],
  },
  // Pick up all your route files with @openapi JSDoc blocks
  apis: ["./src/routes/*.ts"],
};

const swaggerSpec = swaggerJSDoc(options);

export default swaggerSpec;