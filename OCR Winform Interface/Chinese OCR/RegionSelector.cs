using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Data;
using System.Drawing;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Newtonsoft.Json;
using System.Windows.Input;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Xml;
using System.Threading;

namespace Chinese_OCR
{
    public partial class RegionSelector : Form
    {
        private Point startPoint;
        private Rectangle selectionRect;
        private Rectangle previousRect = Rectangle.Empty;
        private Bitmap screenShot;        
        int screenWidth = Screen.PrimaryScreen.Bounds.Width;
        int screenHeight = Screen.PrimaryScreen.Bounds.Height;

        public RegionSelector()
        {
            InitializeComponent();

            this.MouseDown += RegionSelector_MouseDown;
            this.MouseMove += RegionSelector_MouseMove;
            this.MouseUp += RegionSelector_MouseUp;

            DoubleBuffered = true;
        }

        private void RegionSelector_Load(object sender, EventArgs e)
        {


            this.FormBorderStyle = FormBorderStyle.None;
            this.WindowState = FormWindowState.Minimized;

            screenShot = new Bitmap(screenWidth, screenHeight);
            Rectangle captureRectangle = Screen.AllScreens[0].Bounds;
            Graphics captureGraphics = Graphics.FromImage(screenShot);
            captureGraphics.CopyFromScreen(captureRectangle.Left, captureRectangle.Top, 0, 0, captureRectangle.Size);

            this.BackgroundImage = screenShot;
            this.BackgroundImageLayout = ImageLayout.Stretch;
            


            this.WindowState = FormWindowState.Maximized;

            
        }
        private void RegionSelector_MouseDown(object sender, MouseEventArgs e)
        {
            startPoint = e.Location;
            selectionRect = new Rectangle(startPoint, Size.Empty);
            this.Invalidate(); // Invalidate the form to trigger a repaint
        }

        private void RegionSelector_MouseMove(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                // Calculate the width and height of the selection rectangle
                int x = Math.Min(e.X, startPoint.X);
                int y = Math.Min(e.Y, startPoint.Y);
                int width = Math.Abs(e.X - startPoint.X);
                int height = Math.Abs(e.Y - startPoint.Y);

                selectionRect = new Rectangle(x, y, width, height);
                Rectangle invalidatedRegion = Rectangle.Union(previousRect, selectionRect);

                this.Invalidate(invalidatedRegion); // Invalidate the form to trigger a repaint
                previousRect = selectionRect;

            }
        }

        private async void RegionSelector_MouseUp(object sender, MouseEventArgs e)
        {
            Rectangle selectionRectBuffer = selectionRect; // On retient selectionRectangle avant de l'effacer

            selectionRect = Rectangle.Empty; // Puis on l'efface pour ne pas l'avoir sur notre capture finale
            this.Invalidate(); // On met a jour l'affichage

            Bitmap croppedImage = new Bitmap(selectionRectBuffer.Width, selectionRectBuffer.Height);

            using (Graphics g = Graphics.FromImage(croppedImage))
            {
                g.DrawImage(screenShot, new Rectangle(0, 0, croppedImage.Width, croppedImage.Height), selectionRectBuffer, GraphicsUnit.Pixel);
            }

            Thread.Sleep(100);
            this.Hide();
            ScreenShotForm screenShotForm = new ScreenShotForm();
            screenShotForm.Show(ref croppedImage);

        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);

            // Draw the background with the desired opacity
            using (var backgroundBrush = new SolidBrush(Color.FromArgb(64, Color.White)))
            {
                e.Graphics.FillRectangle(backgroundBrush, this.ClientRectangle);
            }

            // Draw the semi-transparent rectangle
            if (selectionRect != null && selectionRect.Width > 0 && selectionRect.Height > 0)
            {
                using (var brush = new SolidBrush(Color.FromArgb(32, Color.White)))
                {
                    e.Graphics.FillRectangle(brush, selectionRect);
                }
            }
        }

    }
}
