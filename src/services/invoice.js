import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '../../public');
const INVOICES_DIR = path.join(PUBLIC_DIR, 'invoices');

/**
 * Generate a premium branded PDF invoice for an order.
 * @param {string} orderId - Unique order/lead ID.
 * @param {Object} orderDetails - Cart, address, customer details.
 * @returns {Promise<string>} Path to the generated PDF file.
 */
export const generateInvoicePDF = async (orderId, orderDetails) => {
  // Ensure target directories exist
  if (!fs.existsSync(INVOICES_DIR)) {
    fs.mkdirSync(INVOICES_DIR, { recursive: true });
  }

  const filePath = path.join(INVOICES_DIR, `invoice_${orderId}.pdf`);
  const doc = new PDFDocument({ margin: 50 });
  const writeStream = fs.createWriteStream(filePath);
  
  doc.pipe(writeStream);

  // --- BRAND HEADER ---
  // Large brand title in dark charcoal
  doc.fillColor('#1d1d1f')
     .fontSize(22)
     .text('THEAURAX', 50, 45, { bold: true });
     
  doc.fillColor('#6e6e73')
     .fontSize(9)
     .text('Premium Football Jerseys & Team Kits', 50, 70);

  // Document title on top right
  doc.fillColor('#1d1d1f')
     .fontSize(16)
     .text('PROFORMA INVOICE', 350, 45, { align: 'right', bold: true });

  // Divider line
  doc.moveTo(50, 85)
     .lineTo(550, 85)
     .strokeColor('#e5e5ea')
     .lineWidth(1)
     .stroke();

  // --- INVOICE & CUSTOMER META ---
  doc.fillColor('#1d1d1f')
     .fontSize(10)
     .text('INVOICE TO:', 50, 105, { bold: true });
  
  doc.fillColor('#333333')
     .fontSize(10)
     .text(`Name/ID: ${orderDetails.customerName || 'Customer (' + orderDetails.userId + ')'}`, 50, 120)
     .text(`Address: ${orderDetails.address || 'Standard Shipping / Self-Checkout'}`, 50, 135, { width: 220 });

  doc.fillColor('#1d1d1f')
     .text('INVOICE DETAILS:', 350, 105, { bold: true });
  
  doc.fillColor('#333333')
     .text(`Invoice Number: TX-${orderId.substring(0, 8).toUpperCase()}`, 350, 120)
     .text(`Date: ${new Date().toLocaleDateString('en-IN')}`, 350, 135)
     .text(`Payment: PENDING (Prepaid/COD)`, 350, 150);

  // --- TABLE HEADER ---
  const tableTop = 200;
  doc.fillColor('#1d1d1f')
     .fontSize(10)
     .text('Item Description', 50, tableTop, { bold: true })
     .text('Size', 270, tableTop, { bold: true })
     .text('Qty', 340, tableTop, { bold: true })
     .text('Price', 400, tableTop, { bold: true })
     .text('Total', 480, tableTop, { bold: true });

  doc.moveTo(50, 215)
     .lineTo(550, 215)
     .strokeColor('#1d1d1f')
     .lineWidth(1.5)
     .stroke();

  // --- TABLE BODY ---
  let yPosition = 230;
  let subtotal = 0;
  const items = orderDetails.cart || [];

  items.forEach((item) => {
    const itemTotal = item.price * item.qty;
    subtotal += itemTotal;

    doc.fillColor('#333333')
       .fontSize(10)
       .text(item.name, 50, yPosition)
       .text(item.size || 'N/A', 270, yPosition)
       .text(item.qty.toString(), 340, yPosition)
       .text(`₹${item.price}`, 400, yPosition)
       .text(`₹${itemTotal}`, 480, yPosition);

    yPosition += 25;
  });

  // Divider after items
  doc.moveTo(50, yPosition)
     .lineTo(550, yPosition)
     .strokeColor('#e5e5ea')
     .lineWidth(1)
     .stroke();

  // --- TOTALS SECTION ---
  yPosition += 15;
  doc.fillColor('#6e6e73')
     .fontSize(10)
     .text('Subtotal:', 350, yPosition)
     .fillColor('#1d1d1f')
     .text(`₹${subtotal}`, 480, yPosition, { align: 'left' });

  yPosition += 20;
  const deliveryFee = 0; // Free shipping rule
  doc.fillColor('#6e6e73')
     .text('Shipping:', 350, yPosition)
     .fillColor('#1d1d1f')
     .text(deliveryFee === 0 ? 'FREE' : `₹${deliveryFee}`, 480, yPosition);

  yPosition += 20;
  const grandTotal = subtotal + deliveryFee;
  doc.fillColor('#1d1d1f')
     .fontSize(11)
     .text('Grand Total:', 350, yPosition, { bold: true })
     .text(`₹${grandTotal}`, 480, yPosition, { bold: true });

  // --- PAYMENT DETAILS ---
  yPosition += 50;
  doc.fillColor('#1d1d1f')
     .fontSize(10)
     .text('HOW TO PAY:', 50, yPosition, { bold: true });

  doc.fillColor('#333333')
     .fontSize(9)
     .text('• UPI Option: Pay via GPAY, PhonePe, or Paytm to UPI ID: ', 50, yPosition + 15)
     .fillColor('#1d1d1f')
     .text('theaurax@upi', 285, yPosition + 15, { bold: true })
     .fillColor('#333333')
     .text('  (Please send payment screenshot to this chat window after paying to verify instantly).', 50, yPosition + 27)
     .text('• Cash on Delivery (COD): Pay cash at the time of delivery (flat ₹50 fee charged by courier).', 50, yPosition + 42);

  // --- FOOTER NOTE ---
  doc.moveTo(50, yPosition + 80)
     .lineTo(550, yPosition + 80)
     .strokeColor('#e5e5ea')
     .stroke();

  doc.fillColor('#8e8e93')
     .fontSize(8)
     .text('Thank you for ordering with Theaurax! Custom printed jerseys cannot be returned/exchanged.', 50, yPosition + 95, { align: 'center' })
     .text('Need help? Reply in this chat or visit https://theaurax.in', 50, yPosition + 107, { align: 'center' });

  doc.end();

  return new Promise((resolve, reject) => {
    writeStream.on('finish', () => resolve(filePath));
    writeStream.on('error', (err) => reject(err));
  });
};

export default generateInvoicePDF;
