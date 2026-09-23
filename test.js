import http from "k6/http";
import { check } from "k6";

export const options = {
    vus: 500,
    duration: "1m",
};

export default function () {
    const res = http.get("http://localhost:5000/api/reports");

    check(res, {
        "status is 200": (r) => r.status === 200,
    });
}