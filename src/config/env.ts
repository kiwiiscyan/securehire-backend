import dotenv from 'dotenv';

export const configEnv = () => {
  dotenv.config();
  if (!process.env.MONGO_URI) {
    console.warn('MONGO_URI not set, using default local.');
  }
};