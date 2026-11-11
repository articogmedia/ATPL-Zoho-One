import Link from "next/link";
import Image from "next/image";
import { ResetPasswordForm } from "@/components/ResetPasswordForm";

export const metadata = { title: "Reset password", robots: { index: false, follow: false } };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F3F6FA] px-4 py-8">
      <section className="w-full max-w-[420px] rounded-2xl border border-[#E5EAF1] bg-white p-7 shadow-lg sm:p-10">
        <div className="mb-6 flex justify-center">
          <Image src="/brand/atpl-logo.webp" width={200} height={84} alt="ATPL - Air Trendz Private Limited" className="h-auto w-[180px] object-contain" priority />
        </div>
        <h1 className="text-2xl font-semibold text-[#172554]">Set a new password</h1>
        <p className="mt-2 text-sm text-slate-600">Choose a password with at least 10 characters.</p>
        <ResetPasswordForm token={token ?? ""} />
        <p className="mt-5 text-center text-sm"><Link href="/login" className="text-primary underline-offset-4 hover:underline">Back to sign in</Link></p>
      </section>
    </main>
  );
}
