import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <div className="mx-auto mt-24 max-w-md px-4 text-center">
      <h1 className="text-xl font-semibold">找不到這個頁面</h1>
      <Link to="/" className="mt-4 inline-block text-blue-600 hover:underline">
        回首頁
      </Link>
    </div>
  );
}
