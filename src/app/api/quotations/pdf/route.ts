import { NextRequest, NextResponse } from "next/server";

const escapePdf = (value: string) => value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function text(x: number, y: number, value: string, size = 10, bold = false) {
  return `BT /F${bold ? 2 : 1} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escapePdf(value)}) Tj ET`;
}

function line(x1: number, y1: number, x2: number, y2: number) {
  return `${x1} ${y1} m ${x2} ${y2} l S`;
}

function rect(x: number, y: number, width: number, height: number) {
  return `${x} ${y} m ${x + width} ${y} l ${x + width} ${y + height} l ${x} ${y + height} l h S`;
}

function pdfDocument(commands: string[]) {
  const stream = commands.join("\n");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    "6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xref = pdf.length;
  pdf += `xref\n0 7\n0000000000 65535 f \n`;
  for (let i = 1; i <= 6; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

export function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const offerNo = searchParams.get("offerNo")?.trim() || "OFFER";
  if (!/^\d{3}\/\d{2}-\d{2}$/.test(offerNo)) {
    return NextResponse.json({ error: "Offer number must use NNN/YY-YY." }, { status: 400 });
  }
  const customer = searchParams.get("customer") ?? "";
  const leadName = searchParams.get("leadName") ?? "";
  const date = searchParams.get("date") ?? "";
  const address = searchParams.get("address") ?? "";
  const items = Array.from(searchParams.entries())
    .filter(([key]) => /^item\d+$/.test(key))
    .map(([, value]) => {
      try { return JSON.parse(value) as { model?: string; unit?: string; qty?: number; price?: number; discount?: number }; }
      catch { return null; }
    })
    .filter((item): item is { model: string; unit: string; qty: number; price: number; discount?: number } => !!item);
  const total = items.reduce((sum, item) => sum + item.qty * item.price - (item.discount ?? 0), 0);
  const money = (value: number) => `Rs. ${Math.round(value).toLocaleString("en-IN")}.00`;
  const commands = [
    text(185, 810, "Air Trendz Pvt. Ltd.", 16, true),
    text(105, 793, "ATPL House, Plot no. 33/C, B K Guda, S R Nagar, Hyderabad, Telangana, India, 500038", 8),
    text(250, 778, "GSTIN - 36AANCA9304M2Z7", 9, true),
    line(40, 765, 555, 765),
    text(40, 748, "Stage", 8, true), text(40, 735, "Draft", 9),
    text(145, 748, "Valid Till", 8, true), text(145, 735, "30 days from offer", 9),
    text(250, 748, "Sales Person", 8, true), text(250, 735, "Reshma", 9),
    text(385, 748, "Amount", 8, true), text(385, 735, money(total), 9, true),
    text(250, 710, "OFFER", 18, true),
    text(250, 692, offerNo, 12, true),
    text(385, 692, `Date: ${date}`, 8),
    text(40, 708, "Bill To", 8, true),
    text(40, 694, customer || leadName, 9),
    text(40, 682, address, 8),
    text(40, 670, "Ship To", 8, true),
    text(40, 656, customer || leadName, 9),
    line(40, 635, 555, 635),
    text(40, 618, "Dear Sir,", 10),
    text(40, 602, "Sub: Your requirement for SAMSUNG MAKE INVERTOR Air Conditioners - reg.", 9, true),
    text(40, 584, "We thank you very much for your enquiry. We are pleased to submit herewith our offer.", 8),
    text(40, 570, "Terms & Conditions", 9, true),
    text(40, 555, "Item & Description", 8, true),
    text(300, 555, "List Price", 8, true),
    text(365, 555, "Qty", 8, true),
    text(420, 555, "Discount", 8, true),
    text(500, 555, "Amount", 8, true),
  ];
  commands.push(rect(40, 80, 515, 462));
  commands.push(line(40, 545, 555, 545));
  let y = 530;
  items.forEach((item, index) => {
    commands.push(text(45, y, String(index + 1), 8));
    commands.push(text(65, y, `${item.model}`, 8));
    commands.push(text(300, y, money(item.price), 8));
    commands.push(text(365, y, `${item.qty} ${item.unit}`, 8));
    commands.push(text(420, y, money(item.discount ?? 0), 8));
    commands.push(text(490, y, money(item.qty * item.price - (item.discount ?? 0)), 8));
    y -= 22;
  });
  commands.push(line(40, 80, 555, 80));
  commands.push(text(360, 64, "Sub Total", 9, true), text(480, 64, money(total), 9));
  commands.push(text(360, 48, "GST", 9, true), text(480, 48, "Rs. 0.00", 9));
  commands.push(text(360, 32, "Grand Total", 10, true), text(480, 32, money(total), 10, true));
  commands.push(text(40, 14, `for Air Trendz Pvt. Ltd. / Reshma / 9490172222 / 9989789222`, 8, true));
  return new NextResponse(pdfDocument(commands), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="offer-${offerNo.replace("/", "-")}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
