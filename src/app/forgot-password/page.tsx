import Link from "next/link";
import Image from "next/image";
import { ForgotPasswordForm } from "@/components/ForgotPasswordForm";

export const metadata = { title: "Forgot password", robots: { index: false, follow: false } };

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F3F6FA] px-4 py-8">
      <section className="w-full max-w-[420px] rounded-2xl border border-[#E5EAF1] bg-white p-7 shadow-lg sm:p-10">
        <div className="mb-6 flex justify-center">
          <Image src="/brand/atpl-logo.webp" width={200} height={84} alt="ATPL - Air Trendz Private Limited" className="h-auto w-[180px] object-contain" priority />
        </div>
        <h1 className="text-2xl font-semibold text-[#172554]">Forgot password?</h1>
        <p className="mt-2 text-sm text-slate-600">Enter your registered email address and we&apos;ll send a reset link if the account is eligible.</p>
        <ForgotPasswordForm />
        <p className="mt-5 text-center text-sm"><Link href="/login" className="text-primary underline-offset-4 hover:underline">Back to sign in</Link></p>
      </section>
    </main>
  );
}
