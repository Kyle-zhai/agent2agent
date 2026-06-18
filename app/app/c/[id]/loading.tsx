export default function ConvLoading() {
  return (
    <div className="h-full flex flex-col">
      <header className="px-5 py-3 border-b border-[color:var(--color-line)] bg-[color:var(--color-paper)]">
        <div className="skeleton-line h-5 w-40" />
        <div className="skeleton-line h-3 w-24 mt-1.5" />
      </header>
      <div className="flex-1 px-6 py-6 space-y-3">
        <div className="flex gap-2">
          <div className="skeleton-line w-8 h-8 !rounded-full" />
          <div className="space-y-1.5 flex-1">
            <div className="skeleton-line h-3 w-32" />
            <div className="skeleton-line h-12 w-2/3 !rounded-2xl" />
          </div>
        </div>
        <div className="flex gap-2 flex-row-reverse">
          <div className="w-8" />
          <div className="space-y-1.5 flex-1 max-w-[60%] ml-auto">
            <div className="skeleton-line h-10 w-3/4 ml-auto !rounded-2xl" />
          </div>
        </div>
        <div className="flex gap-2">
          <div className="skeleton-line w-8 h-8 !rounded-full" />
          <div className="space-y-1.5 flex-1">
            <div className="skeleton-line h-3 w-28" />
            <div className="skeleton-line h-16 w-3/4 !rounded-2xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
