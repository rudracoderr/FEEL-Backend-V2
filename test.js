import http from 'k6/http';

export default function () {
  const res = http.get(
    'https://feel-backend-v2.onrender.com/api/reports'
  );

  console.error(`STATUS: ${res.status}`);
  console.error(`BODY: ${res.body}`);
}



