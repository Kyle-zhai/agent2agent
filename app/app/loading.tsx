export default function AppLoading() {
  return (
    <div className="max-w-3xl mx-auto px-10 py-12">
      <div className="skeleton-line h-6 w-40 mb-4" />
      <div className="skeleton-line h-10 w-72 mb-6" />
      <div className="space-y-2">
        <div className="skeleton-line h-4 w-full" />
        <div className="skeleton-line h-4 w-5/6" />
        <div className="skeleton-line h-4 w-3/4" />
      </div>
    </div>
  );
}
