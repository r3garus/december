export const CryptoPlaceholder = () => {
  return (
    <div className="min-h-0 flex-1 bg-gray-950 p-3 sm:p-6">
      <div className="h-full w-full bg-gray-900 rounded-lg border border-gray-800 flex items-center justify-center">
        <div className="max-w-md px-4 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-green-400 to-blue-500 sm:mb-6 sm:h-20 sm:w-20">
            <svg
              className="h-8 w-8 text-white sm:h-10 sm:w-10"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 4a2 2 0 100-4 2 2 0 000 4z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <h1 className="mb-3 text-xl font-bold text-white sm:mb-4 sm:text-2xl">
            Crypto Dashboard
          </h1>
          <p className="mb-4 text-sm text-gray-400 sm:mb-6 sm:text-lg">
            Your crypto trading interface will be rendered here
          </p>
          <div className="text-sm text-gray-500 space-y-2">
            <p>• Real-time market data</p>
            <p>• Interactive trading charts</p>
            <p>• Portfolio management</p>
            <p>• Price alerts & notifications</p>
          </div>
        </div>
      </div>
    </div>
  );
};
