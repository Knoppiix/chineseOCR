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
using JiebaNet.Segmenter;
using JiebaNet.Segmenter.PosSeg;
using System.Text.Json;

namespace Chinese_OCR
{   

    public partial class ScreenShotForm : Form
    {
        // Public vars
        int screenWidth = Screen.PrimaryScreen.Bounds.Width;
        int screenHeight = Screen.PrimaryScreen.Bounds.Height;
        private float ratio = 2.0f;
        List<string> characterList = new List<string>();
        List<RectangleData> rectangles = new List<RectangleData>();
        float Ratio { get => ratio; set => ratio = value; }
        Bitmap? croppedImg;

        public ScreenShotForm()
        {
            InitializeComponent();            
        }

        public static byte[] ImageToByte2(Image img)
        {
            using (var stream = new MemoryStream())
            {
                img.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
                return stream.ToArray();
            }
        }

        
        public static Bitmap ResizeImage(Image image, int width, int height)
        {
            var destRect = new Rectangle(0, 0, width, height);
            var destImage = new Bitmap(width, height);

            destImage.SetResolution(image.HorizontalResolution, image.VerticalResolution);

            using (var graphics = Graphics.FromImage(destImage))
            {
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.CompositingQuality = CompositingQuality.HighSpeed;
                graphics.InterpolationMode = InterpolationMode.Low;
                graphics.SmoothingMode = SmoothingMode.HighSpeed;
                graphics.PixelOffsetMode = PixelOffsetMode.HighSpeed;

                using (var wrapMode = new ImageAttributes())
                {
                    wrapMode.SetWrapMode(WrapMode.TileFlipXY);
                    graphics.DrawImage(image, destRect, 0, 0, image.Width, image.Height, GraphicsUnit.Pixel, wrapMode);
                }
               
            }
           

            return destImage;
        }
        private void copyButtonClick(object sender, EventArgs e, string characters)
        {
            Clipboard.SetText(characters);
        }

        public class RectangleData
        {
            public Rectangle Rectangle { get; set; }
            public string? Metadata { get; set; }
        }

        
        private async void ScreenShotForm_Load(object sender, EventArgs e)
        {
            this.Hide();
            Bitmap captureBitmap;
            int initialWidth = pictureBox1.Width;
            int initialHeight = pictureBox1.Height;
            pictureBox1.BackgroundImageLayout = ImageLayout.None;
            if (croppedImg == null) // Si on veut prendre un screenshot de l'écran entier
            {
                //Creation du screen            
                captureBitmap = new Bitmap(screenWidth, screenHeight);
                Rectangle captureRectangle = Screen.AllScreens[0].Bounds;
                Graphics captureGraphics = Graphics.FromImage(captureBitmap);
                captureGraphics.CopyFromScreen(captureRectangle.Left, captureRectangle.Top, 0, 0, captureRectangle.Size);
                this.WindowState = FormWindowState.Maximized;
                Ratio = 1.0f;
            }
            else // Sinon si on appelle la forme depuis la capture de région
            {
                 captureBitmap = croppedImg;               
            }
            
            byte[] imageData = ImageToByte2(captureBitmap);

            richTextBox1.Dock = DockStyle.Bottom;
            richTextBox1.Font = new Font("Segoe UI", (int)(float)this.Height / 65);
            pictureBox1.Height = (int)(float)(this.Height * 0.85);
            richTextBox1.Height = (int)(float)(this.Height * 0.06);
            label1.Location = new Point(label1.Location.X, pictureBox1.Height + (int)(float)(this.Height * 0.03));

            //MessageBox.Show(Ratio.ToString());
            pictureBox1.BackgroundImage = captureBitmap;
            //On affiche la forme         
            this.Show();

            try
            {

                using (var httpClient = new HttpClient())
                using (var content = new ByteArrayContent(imageData))
                {
                    httpClient.Timeout = new TimeSpan(1, 1, 1);

                    content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");

                    // Send the PUT request
                    var response = await httpClient.PutAsync("http://127.0.0.1:5000/ocr", content);

                    // Ensure the request was successful
                    response.EnsureSuccessStatusCode();

                    // Read the response content
                    string responseBody = await response.Content.ReadAsStringAsync();


                    // Parse the JSON response
                    using (JsonDocument doc = JsonDocument.Parse(responseBody))
                    {
                        JsonElement root = doc.RootElement;
                        if (root.TryGetProperty("result", out JsonElement resultElement))
                        {
                            Console.WriteLine("OCR Results:");
                            foreach (JsonElement item in resultElement.EnumerateArray())
                            {
                                string ocrResult = item.GetProperty("text").GetString();
                                //Console.WriteLine($"Confidence: {item.GetProperty("confidence").GetDouble()}");
                                //MessageBox.Show($"Bounding Box: {item.GetProperty("bounding_box").GetRawText()}");
                                int x = (int)Math.Round(item.GetProperty("bounding_box")[0][0].GetDouble());
                                //MessageBox.Show("x : " + x.ToString());
                                int y = (int)Math.Round(item.GetProperty("bounding_box")[0][1].GetDouble());
                                int width = (int)Math.Round(item.GetProperty("bounding_box")[1][0].GetDouble() - x);
                                //MessageBox.Show("Width: " + width);
                                int height = (int)Math.Round(item.GetProperty("bounding_box")[2][1].GetDouble() - y);
                                //MessageBox.Show("Height: " + height);

                                using (Graphics g = pictureBox1.CreateGraphics())
                                {
                                    Rectangle rectangle = new Rectangle(x, y, width, height);
                                    string metadata = ocrResult;

                                    RectangleData rectangleData = new RectangleData
                                    {
                                        Rectangle = rectangle,
                                        Metadata = metadata
                                    };

                                    rectangles.Add(rectangleData);

                                    g.DrawRectangle(Pens.LimeGreen, rectangle);
                                    g.FillRectangle(new SolidBrush(Color.FromArgb(64, Color.LimeGreen)), rectangle);
                                }
                            }
                        }
                        else if (root.TryGetProperty("error", out JsonElement errorElement))
                        {
                            MessageBox.Show($"API returned an error: {errorElement.GetString()}");
                        }
                        else
                        {
                            MessageBox.Show("Unexpected response format from the API.");
                        }

                    }
                }
            }
            catch (HttpRequestException error)
            {
                MessageBox.Show($"An error occurred while sending the request: {error.Message}");
            }
            catch (System.Text.Json.JsonException error)
            {
                MessageBox.Show($"An error occurred while parsing the response: {error.Message}");
            }
            catch (Exception error)
            {
                MessageBox.Show($"An unexpected error occurred: {error.Message}");
            }

        }

        private void DrawRectangles(Graphics g)
        {
            foreach (var rectangleData in rectangles)
            {
                Rectangle rectangle = rectangleData.Rectangle;
                string metadata = rectangleData.Metadata;

                int alpha = 100;
                Color fillColor = Color.FromArgb(alpha, Color.LimeGreen);

                g.DrawRectangle(Pens.LimeGreen, rectangle);
                g.FillRectangle(new SolidBrush(fillColor), rectangle);
            }
        }

        private void pictureBox1_Paint(object sender, PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            DrawRectangles(g);
        }

        private void ScreenShotForm_Click(object sender, EventArgs e)
        {
            _ = MousePosition.X;
            _ = MousePosition.Y;
        }

        public void ShowDefinition(string txtSelected, Label label1)
        {
            Thread.Sleep(100);
            XmlDocument doc = new XmlDocument();
            doc.Load("cfdict.xml");
            foreach (XmlNode node in doc.DocumentElement.ChildNodes)
            {
                if (node.SelectSingleNode("simp").InnerText == txtSelected)
                {
                    XmlNode definitions = node.SelectSingleNode("trans");
                    foreach (XmlNode subnode in definitions)
                    {
                        MethodInvoker inv = delegate
                        {
                            label1.Text += subnode.InnerText + " ; ";
                        };
                        this.Invoke(inv); 
                    }
                }
            }
        }
        private void richTextBox1_SelectionChanged(object sender, EventArgs e)
        {
            Thread.Sleep(200);
            string txtSelected = richTextBox1.SelectedText;
            bool enabled = txtSelected.Length > 0;

            if (enabled)
            {
                label1.Text = richTextBox1.SelectedText;
                pictureBox1.Invalidate(); // On re-dessine les rectangles car rafraichir le label les fait disparaitre
                ThreadStart starter = delegate { ShowDefinition(txtSelected, label1); };
                Thread nodeSearching = new Thread(starter);
                nodeSearching.Start();                
            }
            else
            {
                 enabled = false;
            }
        }

        public void Show(ref Bitmap Img)
        {
            croppedImg = Img;
            this.Show();
        }

        private void pictureBox1_Click(object sender, EventArgs e)
        {
            Point mouseLocation = pictureBox1.PointToClient(MousePosition);            
            // Find the clicked rectangle
            RectangleData clickedRectangleData = rectangles.FirstOrDefault(rd => rd.Rectangle.Contains(mouseLocation));

            if (clickedRectangleData != null)
            {
                // Retrieve the associated metadata
                string metadata = clickedRectangleData.Metadata;
                richTextBox1.Text += metadata;
            }
        }
    }
}
